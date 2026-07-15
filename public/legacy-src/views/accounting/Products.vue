<template>
  <main class="main-content">
    <div class="row">
      <div class="col-lg-7">
        <div class="card">
          <div class="card-header d-flex justify-content-between">
            <h5>گروه کالا</h5>
            <div class="top-items form-inline">
              <input type="search" class="form-control input-sm ml-2 d-none" placeholder="جستجو . . .">
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
        <div class="card">
          <div class="card-header"><h5>افزودن کالای جدید</h5></div>
          <div class="card-body">
            <div class="form-group">
              <label>عنوان کالا</label>
              <input name="" type="text" class="form-control">
            </div>
            <div class="form-group">
              <label>کد کالا</label>
              <input idname="" type="text" class="form-control">
            </div>
            <div class="form-group">
              <label>بارکد</label>
              <input barcode="" type="text" class="form-control">
            </div>

          </div>
        </div>
        <input type="hidden" id="nestable-output">
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
      items: "",
      cats: [],
    }
  },
  methods:{
    async getCats(type, number=''){
      await axios.post('https://shygun.4mk.ir/api/categories/search', {type, number}).then(({data}) => {
        if( data && data.ok ){
          for(let item of data.list.filter(value => !value.ParentId)){
            this.cats[item.GroupId] = {
              GroupNumber: item.GroupNumber,
              GroupName: item.GroupName,
              children: data.list.filter(value => value.ParentId == item.GroupId)
            }
          }
        }else{
          toastr['error']("خطا در دریافت اطلاعات.");
        }
      });
    }
  },
  async created() {
    let vm = this;
    await this.getCats(-1);
    var output;

    function buildItem(item) {
      var html = `<li class="dd-item dd3-item" data-id="${item.GroupNumber}" data-title="${item.GroupName}">`;
      html += `<div class="dd3-handle dd4-handle"><i class="fa fa-bars text-white"></i></div>
            <div class="dd3-content">
                <div class="d-flex justify-content-between">
                    <span>${item.GroupName}</span>
                    ${item.ParentId>0?'<div class="align-middle"> <a href="#" data-toggle="rule-show"><i class="fa fa-arrow-custom fa-arrow-circle-o-left"></i></a> </div>' : ''}
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
      output = '';
      for(let item of vm.cats){
        if( item ){
          output += buildItem(item);
        }
      }
      $('#nestable1 .dd-list').html(output);

      var updateOutput = function () {
        var e = $('#nestable1');
        var list = e.length ? e : $(e.target),
            output = list.data('output');
        if (window.JSON) {
          output.val(window.JSON.stringify(list.nestable('serialize')));
        } else {
          output.val('JSON browser support required for this demo.');
        }
      };

      $('#nestable1').nestable().on('change', updateOutput);
      updateOutput($('#nestable1').data('output', $('#nestable-output')));
    }

    $(function () {
      updateItems();

      $("[data-action=expand-all]").click(function () {
        $('.dd').nestable('expandAll');
      });
      $("[data-action=collapse-all]").click(function () {
        $('.dd').nestable('collapseAll');
      });

      $('#nestable1 .dd-list').on('click', "[data-toggle^=rule-]", function (){
        var li = $(this).parents('.dd-item.dd3-item');

        return false;
      });

      $("[data-action=collapse-all]").click();
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
.card-header .fa-refresh{font-size: 17px; margin-top: 5px;}
.dd3-handle{
  height: 30px;
  border-radius: 0 4px 4px 0;
}
.input-sm{
  height: 29px;
  font-size: 13px;
}
</style>
<style>
.dd4-handle{
  height: 30px;
  border-radius: 0 4px 4px 0;
}
.fa-arrow-custom{
  font-size: 22px;
  margin-top: -3px;
  margin-left: -4px;
}
</style>
