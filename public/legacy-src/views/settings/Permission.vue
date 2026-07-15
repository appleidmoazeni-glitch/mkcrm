<template>
  <main class="main-content">
    <div class="row">
      <div class="col-lg-7">
        <div class="card">
          <div class="card-header d-flex justify-content-between">
            <h5>لیست سطح دسترسی ها</h5>
            <div class="top-items">
              <button @click="saveChanges" type="button" class="btn btn-sm btn-primary ml-2 btn-save" data-action="expand-all">ذخیره</button>
              <button id="reloadData" class="d-none" type="button">Reload</button>
              <div class="btn-group btn-group-sm" id="nestable-menu">
                <button type="button" class="btn btn-primary" data-action="expand-all"><i class="fa fa-plus"></i></button>
                <button type="button" class="btn btn-primary" data-action="collapse-all"><i class="fa fa-minus"></i></button>
              </div>
            </div>
          </div>
          <b-overlay :show="pLoading" opacity="0.6" rounded="lg" class="card-body">
            <div class="dd" id="nestable1">
              <ol class="dd-list"></ol>
            </div>
          </b-overlay>
        </div>
      </div>
      <div class="col-lg-5">
        <form @submit.prevent="" method="POST" id="formAddNew" class="card needs-validation">
          <div class="card-header"><h5>افزودن سطح دسترسی جدید</h5></div>
          <div class="card-body">
            <div class="form-group">
              <label>عنوان</label>
              <input type="text" name="title" class="form-control" placeholder="عنوان" required="">
            </div>
            <div class="form-group">
              <label>نوع</label>
              <select data-module="select2" name="type" required="">
                <option value="primary">اصلی</option>
                <option value="cmd">فرمان</option>
                <option value="menu">منو</option>
              </select>
            </div>
            <div class="form-group">
              <label>سطح دسترسی پدر</label>
              <select data-module="select2" name="parent">
                <option value="0">اصلی</option>
                <option v-model="mainRules" v-for="rule of mainRules" :value="rule._id">{{ rule.title }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>متن مجوز</label>
              <textarea class="form-control" dir="ltr" name="rule" rows="5" required=""></textarea>
            </div>
            <button type="button" class="btn btn-success full" @click="addRule">افزودن</button>
          </div>
        </form>
        <input type="hidden" id="nestable-output">
      </div>
    </div>

    <div class="modal fade" id="editRule" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <b-overlay :show="erLoading" opacity="0.6" rounded="lg" class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">ویرایش <strong></strong></h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>
          <div class="modal-body">
            <form @submit.prevent="" method="POST" class="card needs-validation">
              <div class="form-group">
                <label>عنوان</label>
                <input type="text" name="title" class="form-control" placeholder="عنوان" required="">
              </div>
              <div class="form-group">
                <label>نوع</label>
                <select data-module="select2" name="type" required="">
                  <option value="primary">اصلی</option>
                  <option value="cmd">فرمان</option>
                  <option value="menu">منو</option>
                </select>
              </div>
              <div class="form-group">
                <label>متن مجوز</label>
                <textarea class="form-control" dir="ltr" name="rule" rows="5" required=""></textarea>
                <input type="hidden" name="id">
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
            <button type="button" @click="editRule" class="btn btn-primary">اعمال</button>
          </div>
        </b-overlay>
      </div>
    </div>
  </main>
</template>

<script>
import "../../../public/vendors/nestable/jquery.nestable.rtl";
import axios from "axios";
export default {
  data(){
    return {
      pLoading: false,
      erLoading: false,
      items: "",
      rules: [],
      mainRules: []
    }
  },
  methods:{
    async getRules(){
      this.pLoading = true;
      let permissions = (await axios.get('/admin/settings/permission.r')).data;
      if( permissions.ok ){
        this.mainRules = [];
        this.rules = permissions.rules.filter((e) => {
          let isMain = !isNaN(e.parent);
          delete e.parent;

          if( isMain ){
            this.mainRules.push( e )
          }

          return e;
        });
      }else{
        toastr['error']("خطای ناشناخته");
      }
      this.pLoading = false;
    },
    saveChanges(){
      axios.put('/admin/settings/permission.r', {data: $("#nestable-output").val()}).then(({data}) => {
        if( data.ok ){
          toastr['success']("تغییرات با موفقیت انجام شدند .");
        }else{
          toastr['error']("خطای ذخیره سازی .");
        }
      });
    },
    addRule(){
      axios.post('/admin/settings/permission.r', $("#formAddNew").serialize()).then(({data}) => {
        if( data.ok ){
          toastr['success'](data.msg);
          $("#formAddNew").trigger("reset");
          $("#formAddNew input").first().focus();
          $("[name='parent']").trigger('change');

          this.reloadPData();
          this.getRules();
        }else{
          toastr['error'](data.error);
        }
      });
    },
    editRule(){
      let modal = $("#editRule").find('form'),
          id = modal.find('[name=id]').val();

      axios.put('/admin/settings/permission.r', modal.serialize(), {params: {id}}).then(({data}) => {
        $("#editRule").modal('hide');
        if( data.ok ){
          toastr['success']("ویرایش با موفقیت انجام شد.");
          this.reloadPData();
        }else{
          toastr['error']("خطایی در ذخیره سازی اطلاعات.")
        }
      });
    },
    async reloadPData(){
      await this.getRules();
      $("#reloadData").click();
    }
  },
  async created() {
    let vm = this;
    await this.getRules();
    var obj,output;

    function buildItem(item) {
      var html = `<li class="dd-item dd3-item" data-id="${item._id}" data-title="${item.title}">`;
      html += `<div class="dd-handle dd3-handle"><i class="fa ${item.type == 'menu' ? 'fa-bars' : (item.type == 'primary' ? 'fa-globe' : 'fa-cubes')} text-white"></i></div>
            <div class="dd3-content">
                <div class="d-flex justify-content-between">
                    <span>${item.title}</span>
                    <div class="align-middle">
                        <a href="#" data-toggle="modal" data-target="#editRule"><i class="fa fa-pencil"></i></a>
                        <a href="#" id="deleteItem"><i class="fa fa-trash"></i></a>
                    </div>
                </div>
            </div>`;

      if (item.children) {
        html += `<ol class="dd-list">`;
        $.each(item.children, function (index, sub) {
          html += buildItem(sub);
        });
        html += `</ol>`;
      }

      html += "</li>";
      return html;
    }

    function updateItems(){

      obj = JSON.stringify(vm.rules);
      output = '';

      $.each(JSON.parse(obj), function (index, item) {
        output += buildItem(item);
      });
      $('#nestable1 .dd-list').html(output);

      var updateOutput = function () {
        var e = $('#nestable1');
        var list = e.length ? e : $(e.target),
            output = list.data('output');
        if (window.JSON) {
          output.val(window.JSON.stringify(list.nestable('serialize'))); //, null, 2));
          // console.log(list.nestable('serialize'));
        } else {
          output.val('JSON browser support required for this demo.');
        }
      };

      $('#nestable1').nestable().on('change', updateOutput);
      updateOutput($('#nestable1').data('output', $('#nestable-output')));

    }

    $(function () {

      updateItems();

      $("#reloadData").click(function(){
        updateItems();
      });

      $("[data-action=expand-all]").click(function () {
        $('.dd').nestable('expandAll');
      });
      $("[data-action=collapse-all]").click(function () {
        $('.dd').nestable('collapseAll');
      });

      $("#nestable1").on('click', "#deleteItem", function (){
        var item = $(this).parents("[data-id]");
        swal({
          title: "آیا اطمینان دارید؟",
          text: `آیا واقعا می خواید سطح دسترسی ${item.data('title')} را حذف کنید؟`,
          icon: "warning",
          buttons: {
            confirm : 'بله',
            cancel : 'خیر'
          },
          dangerMode: true
        }).then(function(willLock) {
          if (willLock) {
            axios.delete("/admin/settings/permission.r", {params: {id: item.data('id')}}).then(({data}) => {
              if( data.ok ){
                swal(`سطح دسترسی فوق با موفقیت حذف شد.`, {
                  icon: "success",
                  button: "باشه"
                });
                vm.reloadPData();
              }
            });
          }
        });

        return false;
      });

      $('#editRule').on('show.bs.modal', function (event) {
        vm.erLoading = true;
        var btn = $(event.relatedTarget), modal = $(this),
            id = btn.parents("[data-id]").data('id'),
            title = btn.parents(".d-flex").find('span').text();

        modal.find('.modal-title strong').text(title);
        modal.find('.modal-body [name=title]').val(title);

        axios.get('/admin/settings/permission.r', {params: {rid: id}}).then(({data}) => {
          if( data.ok ){
            modal.find('.modal-body [name=type]').val(data.rule.type).trigger('change');
            modal.find('.modal-body [name=rule]').val(data.rule.rule);
            modal.find('.modal-body [name=id]').val(id);
          }else{
            toastr['error']("خطا در فراخوانی اطلاعات سطح دسترسی .");
            $('#editRule').modal('hide');
          }

          vm.erLoading = false;
        });
      });
    });
  }
}
</script>

<style scoped>
@import "../../../public/vendors/nestable/nestable.css";
.align-middle a{
  margin-right: 4px;
}
.btn-save{padding: 6px 12px;}
textarea[name=rule]{font-family: Tahoma}

</style>
