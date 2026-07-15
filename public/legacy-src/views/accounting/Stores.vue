<template>
  <main class="main-content">
    <div id="accordion">
      <div class="card">
        <div class="card-header bg-light d-flex justify-content-between">
          <h5>لیست فروشگاه‌ها</h5>
          <button class="btn btn-success" data-toggle="modal" data-target="#addUser">افزودن فروشنده</button>
        </div>
        <div v-for="store of stores">
          <div class="card-header d-flex justify-content-between">
            <h5 class="mb-0" data-toggle="collapse" :data-target="'#store_'+store._id" aria-expanded="true"><i :class="'fad text-primary ml-2 '+(store.type=='store'?'fa-store':'fa-wifi')"></i> {{store.name}}</h5>
            <span class="btn btn-light-info">{{store.users.length}}</span>
          </div>
          <div :id="'store_'+store._id" class="collapse" data-parent="#accordion">
            <div class="card-body p-0">
              <div class="table-responsive">
                <table class="table table-hover">
                  <thead>
                  <tr class="btn-light">
                    <th width="200">نام</th>
                    <th width="200">نام کاربری</th>
                    <th width="100">تلفن همراه</th>
                    <th></th>
                  </tr>
                  </thead>
                  <tbody>
                  <tr v-for="user of store.users">
                    <td>{{user.fname}} {{user.lname}}</td>
                    <td>{{user.username}}</td>
                    <td>{{user.mobile}}</td>
                    <td class="text-left"><button @click="deleteUserFromStore(user.username, user.id, store._id)" class="btn btn-danger btn-sm"><i class="far fa-trash-alt"></i></button></td>
                  </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <form id="addStore" @submit.prevent="addStore" method="post" class="card">
      <div class="card-header"><h5>افزودن فروشگاه جدید</h5></div>
      <div class="card-body">
        <div class="row">
          <div class="col-lg-6">
            <div class="form-group">
              <label class="col-form-label">نام فروشگاه:</label>
              <input name="name" type="text" class="form-control">
            </div>
          </div>
          <div class="col-lg-6">
            <label class="col-form-label">نوع فروشگاه:</label>
            <select data-module="select2" name="type">
              <option value="store">فیزیکی</option>
              <option value="site">اینترنتی</option>
            </select>
          </div>
        </div>
      </div>
      <div class="card-footer text-muted">
        <button type="submit" class="btn btn-success">افزودن فروشگاه</button>
      </div>
    </form>

    <div class="modal fade" id="addUser" tabindex="-1" role="dialog" aria-hidden="true">
      <form id="addUserToStore" method="post" @submit.prevent="addUserToStore" class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">تعریف فروشنده جدید<span></span></h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="col-form-label">کاربر:</label>
              <select id="username" data-module="select2" name="username"></select>
            </div>
            <div class="form-group">
              <label class="col-form-label">فروشگاه:</label>
              <select data-module="select2" name="store">
                <option value="">[ انتخاب کنید ]</option>
                <option v-for="store of stores" :value="store._id">{{store.name}}</option>
              </select>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
            <button type="submit" class="btn btn-primary">ثبت</button>
          </div>
        </div>
      </form>
    </div>
  </main>
</template>
<style>
[data-toggle="collapse"]{
  cursor: pointer;
}
</style>
<style scoped>
.table:not(.table-bordered) thead th:first-child {
  padding-right: 22px;
}
.table:not(.table-bordered) td:first-child {
  padding-right: 24px;
}
.table:not(.table-bordered) td:last-child {
  padding-left: 26px;
}
</style>
<script>
import axios from "axios";

export default{
  data(){
    return {
      stores: []
    }
  },
  methods:{
    addStore(){
      axios.post('/admin/accounting/stores/list', $('form#addStore').serialize()).then(({data}) => {
        if( data && data.ok){
          toastr['success'](data.msg);
          this.getStores();
        }else{
          toastr['error']("خطا در فراخوانی داده‌ها");
        }
      });
    },
    getStores(){
      axios.get('/admin/accounting/stores/list').then(({data}) => {
        if( data && data.ok ){
          this.stores = data.list;
        }else{
          toastr['error']("خطا در فراخوانی داده‌ها");
        }
      });
    },
    addUserToStore(){
      axios.put('/admin/accounting/stores/list', $("form#addUserToStore").serialize()).then(({data}) => {
        if( data && data.ok ){
          toastr['success'](data.msg);
          this.getStores();
        }else{
          toastr['error'](data.error);
        }
      });

      $("#addUser [name=username]").empty();
      $("#addUser").modal('hide');
    },
    deleteUserFromStore(username, uid, store){
      const vm = this;
      swal({
        title: "آیا اطمینان دارید؟",
        text: `آیا واقعا می خواهید کاربر ${username} را از فروشگاه حذف کنید؟`,
        icon: "warning",
        buttons: {
          confirm : 'بله',
          cancel : 'خیر'
        },
        dangerMode: true
      }).then(function(willDelete) {
        if (willDelete) {
          axios.delete("/admin/accounting/stores/list", {params: {user: uid, store}}).then(({data}) => {
            if( data.ok ){
              swal(`کاربر ${username} با موفقیت حذف شد.`, {
                icon: "success",
                button: "باشه"
              });
              vm.getStores();
            }
          });
        }
      });
    }
  },
  mounted() {
    this.getStores();

    $(function(){
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
    });
  }
}
</script>
