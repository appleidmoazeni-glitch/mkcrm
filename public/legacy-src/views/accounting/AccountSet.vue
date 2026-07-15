<template>
  <main ref="form" class="main-content">
    <div class="card">
      <div class="card-header">
        <h5 v-if="formType=='new'">افزودن دسترسی جدید</h5>
        <h5 v-else>
          ویرایش دسترسی {{getList[activeIndex].fullname}}
          <button @click.prevent="toggleAccessform" type="button" class="btn btn-light btn-floating pull-left"><i class="ti-close"></i></button>
        </h5>
      </div>
      <form class="card-body">
        <div class="row">
          <div :class="[(formType=='new'?'':'d-none'), 'col-lg-6']">
            <div class="form-group">
              <label class="col-form-label">کاربر:</label>
              <select id="username" data-module="select2" name="username"></select>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="form-group">
              <label class="col-form-label">نام کاربری در شایگان:</label>
              <select id="accUser" data-module="select2" name="accUser"></select>
            </div>
            <input type="hidden" name="accUserTitle">
          </div>
        </div>
        <hr>
        <div class="row">
          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">نام مشتری:</label>
              <select id="AccountName" data-module="select2" name="AccountName"></select>
            </div>

            <div class="form-group">
              <label class="col-form-label">کد مشتری:</label>
              <input type="text" class="form-control" readonly name="AccountNumber">
            </div>
          </div>
          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">نام نماینده فروش:</label>
              <select id="SAccountName" data-module="select2" name="SAccountName"></select>
            </div>

            <div class="form-group">
              <label class="col-form-label">کد نماینده فروش:</label>
              <input type="text" class="form-control" readonly name="SAccountNumber">
            </div>
          </div>

          <hr>
          <div class="col-12">سایر حساب ها</div>

          <div class="col-6">
            <div :class="['form-group', formType=='new'?'':'ex-field-group']">
              <select id="ExAccount1" data-module="select2" name="ExAccount1"></select>
              <button type="button" v-if="formType=='edit'" @click="clearSelect('#ExAccount1')" class="btn btn-danger ex-field"><i class="fa fa-trash"></i></button>
            </div>
          </div>
          <div class="col-6">
            <div :class="['form-group', formType=='new'?'':'ex-field-group']">
              <select id="ExAccount2" data-module="select2" name="ExAccount2"></select>
              <button type="button" v-if="formType=='edit'" @click="clearSelect('#ExAccount2')" class="btn btn-danger ex-field"><i class="fa fa-trash"></i></button>
            </div>
          </div>
          <div class="col-6">
            <div :class="['form-group', formType=='new'?'':'ex-field-group']">
              <select id="ExAccount3" data-module="select2" name="ExAccount3"></select>
              <button type="button" v-if="formType=='edit'" @click="clearSelect('#ExAccount3')" class="btn btn-danger ex-field"><i class="fa fa-trash"></i></button>
            </div>
          </div>
          <div class="col-6">
            <div :class="['form-group', formType=='new'?'':'ex-field-group']">
              <select id="ExAccount4" data-module="select2" name="ExAccount4"></select>
              <button type="button" v-if="formType=='edit'" @click="clearSelect('#ExAccount4')" class="btn btn-danger ex-field"><i class="fa fa-trash"></i></button>
            </div>
          </div>
        </div>
        <input type="hidden" name="id" v-if="formType=='edit'" :value="getList[activeIndex].id">
      </form>
      <div class="card-footer">
        <button v-if="formType=='new'" class="btn btn-success" @click="addAccess">اعمال دسترسی</button>
        <button v-else class="btn btn-success" @click="editAccess">ویرایش دسترسی</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header d-flex justify-content-between">
        <h5>لیست دسترسی ها</h5>
        <div class="form-inline">
          <input type="search" v-model="accessFilter" class="form-control" placeholder="جستجو ...">
        </div>
      </div>
      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-hover">
            <thead>
            <tr>
              <th>نام</th>
              <th>نام کاربری</th>
              <th>اکانت حسابداری</th>
              <th>توسط</th>
              <th>در تاریخ</th>
              <th>صندوق</th>
              <th>نماینده</th>
              <th></th>
            </tr>
            </thead>
            <tbody>
            <tr v-for="(item, index) of getList" :class="index==activeIndex?'bg-info-bright':''">
              <td>{{item.fullname}}</td>
              <td>{{item.username}}</td>
              <td>{{item.accUserTitle}}</td>
              <td>{{item.ownerName}}</td>
              <td>{{new Date(item.createdAt).echoFa("Y/m/d")}}</td>
              <td>{{item.AccountName}}</td>
              <td>{{item.SAccountName}}</td>
              <td class="text-left">
                <button class="btn btn-info ml-2 btn-xs" @click="toggleAccessform(index)">ویرایش</button>
                <button class="btn btn-danger btn-xs" data-toggle="modal" :data-index="index" data-target="#acceptRemove">حذف</button>
              </td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="modal fade" id="acceptRemove" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">هشدار</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>
          <div class="modal-body">آیا واقعا می خواهید این دسترسی را حذف کنید؟</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
            <button @click="removeAccess" type="button" class="btn btn-danger">حذف کن</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script>
import axios from "axios";

export default {
  data(){
    return {
      list: [],
      activeIndex: -1,
      formType: "new",
      accessFilter: ""
    }
  },
  computed:{
    getList(){
      if(this.accessFilter){
        return this.list.filter(value => {
          if(
              value.fullname.indexOf(this.accessFilter) != -1 ||
              value.username.indexOf(this.accessFilter) != -1
          ){
            return true;
          }else{
            return false;
          }
        })
      }else{
        return this.list;
      }
    }
  },
  methods:{
    toggleAccessform(index=-1){
      // this.$refs.form.scrollIntoView({behavior: "smooth"});
      window.scrollTo({top: 0, left: 0, behavior: "smooth"});

      $("#username, #AccountName, #SAccountName, #ExAccount1, #ExAccount2, #ExAccount3, #ExAccount4, #accUser").empty();
      $("[name=AccountNumber], [name=SAccountNumber], [name=accUserTitle]").val('');

      if( index > -1 ){
        this.activeIndex = index;
        this.formType = "edit";

        $("#AccountName").empty();
        $('#AccountName').append(new Option(this.getList[index].AccountName, this.getList[index].AccountName, false, false)).trigger('change');
        $("[name=AccountNumber]").val(this.getList[index].AccountNumber);

        $("#SAccountName").empty();
        $('#SAccountName').append(new Option(this.getList[index].SAccountName, this.getList[index].SAccountName, false, false)).trigger('change');
        $("[name=SAccountNumber]").val(this.getList[index].SAccountNumber);

        $("#accUser").empty();
        $('#accUser').append(new Option(this.getList[index].accUserTitle, this.getList[index].accUser, false, false)).trigger('change');
        $("[name=accUserTitle]").val(this.getList[index].accUserTitle);

        for(let i in this.getList[index].ExAccounts){
          let j = parseInt(i)+1;
          $("#ExAccount" + j).empty();
          $("#ExAccount" + j).append(new Option(this.getList[index].ExAccounts[i].AccountName, this.getList[index].ExAccounts[i].AccountNumber + '||' + this.getList[index].ExAccounts[i].AccountName, false, false)).trigger('change');
        }

      }else{
        this.activeIndex = -1;
        this.formType = "new";
      }
    },
    clearSelect(name){
      $(name).empty();
    },
    addAccess(){
      axios.post('/admin/accounting/addAccAccess', $("form").serialize()).then(({data}) => {
        if( data.ok ) {
          toastr['success'](data.msg);
          this.getAccessList();
        }else{
          toastr['error'](data.error);
        }
      });
    },
    editAccess(){
      axios.put('/admin/accounting/addAccAccess', $("form").serialize()).then(({data}) => {
        if( data.ok ) {
          toastr['success'](data.msg);
          this.getAccessList();
        }else{
          toastr['error'](data.error);
        }
      });
    },
    removeAccess(){
      axios.delete('/admin/accounting/addAccAccess', {params: {id: this.getList[this.activeIndex].id}}).then(({data}) => {
        $("#acceptRemove").modal('hide');
        if( data && data.ok ){
          toastr['success'](data.msg);
          this.getAccessList();
        }else{
          toastr['error']("خطایی در فراخوانی اطلاعات رخ داده است");
        }
      });
    },
    async getAccessList(){
      axios.get('/admin/accounting/accAccessList').then(({data}) => {
        if( data.ok ) {
          this.list = data.list
        }else{
          toastr['error'](data.error);
        }
      });
    }
  },
  mounted() {
    const vm = this;
    this.getAccessList();
    $(document).ready(function() {
      $('#username').select2({
        minimumInputLength: 1,
        ajax: {
          url: '/admin/userList',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              query: params.term
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.users, function (item) {
                  return {
                    text: item.fullname + ' (' + item.username + ')',
                    id: item.id
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#accUser').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/auth/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              search: params.term
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: `${item.FullName} (${item.UserName})`,
                    id: item.Userid
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });
      $('#accUser').on('select2:select', function (e) {
        var data = e.params.data;
        $("[name=accUserTitle]").val(data.text);
      });

      $('#AccountName').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountName,
                    no: item.AccountNumber,
                    scode: item.Scode1
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#AccountName').on('select2:select', function (e) {
        var data = e.params.data;
        $("[name=AccountNumber]").val(data.no);
        axios.post('https://shygun.4mk.ir/api/customerName/search', {name: `:${data.scode}`}).then(({data}) => {
          if (data && data.ok) {
            $("#SAccountName").empty();
            $('#SAccountName').append(new Option(data.list[0].AccountName, data.list[0].AccountName, false, false)).trigger('change');
            $("[name=SAccountNumber]").val(data.list[0].AccountNumber);
          }
        });
      });

      $('#SAccountName').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountName,
                    no: item.AccountNumber
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#ExAccount1, #ExAccount2, #ExAccount3, #ExAccount4').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountNumber + '||' + item.AccountName
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#SAccountName').on('select2:select', function (e) {
        var data = e.params.data;
        $("[name=SAccountNumber]").val(data.no);
      });

      $('#acceptRemove').on('show.bs.modal', function (event) {
        var el = $(event.relatedTarget), modal = $(this), i = el.data('index');;
        vm.activeIndex = i;
      });
    });
  }
}
</script>

<style scoped>
.btn-xs {padding: 2px 5px;font-size: 11px;height: 21px;}
.ex-field{position: absolute; left: 13px;top: 1px;}
.ex-field-group{width: calc(100% - 46px);}
</style>
